# ResolveRetrieval200ResponsePolicy


## Properties

Name | Type | Description | Notes
------------ | ------------- | ------------- | -------------
**memory_retrieval_required** | **bool** |  |
**rule_version** | **str** |  |
**skill_retrieval_required** | **bool** |  |

## Example

```python
from openapi_client.models.resolve_retrieval200_response_policy import ResolveRetrieval200ResponsePolicy

# TODO update the JSON string below
json = "{}"
# create an instance of ResolveRetrieval200ResponsePolicy from a JSON string
resolve_retrieval200_response_policy_instance = ResolveRetrieval200ResponsePolicy.from_json(json)
# print the JSON string representation of the object
print(ResolveRetrieval200ResponsePolicy.to_json())

# convert the object into a dict
resolve_retrieval200_response_policy_dict = resolve_retrieval200_response_policy_instance.to_dict()
# create an instance of ResolveRetrieval200ResponsePolicy from a dict
resolve_retrieval200_response_policy_from_dict = ResolveRetrieval200ResponsePolicy.from_dict(resolve_retrieval200_response_policy_dict)
```
[[Back to Model list]](../README.md#documentation-for-models) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to README]](../README.md)
