# ResolveRetrieval200ResponseClassification


## Properties

Name | Type | Description | Notes
------------ | ------------- | ------------- | -------------
**labels** | **List[str]** |  |
**personal_context_required** | **bool** |  |
**primary** | **str** |  |

## Example

```python
from openapi_client.models.resolve_retrieval200_response_classification import ResolveRetrieval200ResponseClassification

# TODO update the JSON string below
json = "{}"
# create an instance of ResolveRetrieval200ResponseClassification from a JSON string
resolve_retrieval200_response_classification_instance = ResolveRetrieval200ResponseClassification.from_json(json)
# print the JSON string representation of the object
print(ResolveRetrieval200ResponseClassification.to_json())

# convert the object into a dict
resolve_retrieval200_response_classification_dict = resolve_retrieval200_response_classification_instance.to_dict()
# create an instance of ResolveRetrieval200ResponseClassification from a dict
resolve_retrieval200_response_classification_from_dict = ResolveRetrieval200ResponseClassification.from_dict(resolve_retrieval200_response_classification_dict)
```
[[Back to Model list]](../README.md#documentation-for-models) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to README]](../README.md)
