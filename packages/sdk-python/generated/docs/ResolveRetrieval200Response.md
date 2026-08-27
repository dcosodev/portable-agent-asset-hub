# ResolveRetrieval200Response


## Properties

Name | Type | Description | Notes
------------ | ------------- | ------------- | -------------
**candidates_considered** | **int** |  |
**classification** | [**ResolveRetrieval200ResponseClassification**](ResolveRetrieval200ResponseClassification.md) |  |
**limits** | [**ResolveRetrieval200ResponseLimits**](ResolveRetrieval200ResponseLimits.md) |  |
**materialization** | [**ResolveRetrieval200ResponseMaterialization**](ResolveRetrieval200ResponseMaterialization.md) |  |
**memories** | [**List[ResolveRetrieval200ResponseMemoriesInner]**](ResolveRetrieval200ResponseMemoriesInner.md) |  |
**memory_candidates_considered** | **int** |  |
**no_match** | **bool** |  |
**policy** | [**ResolveRetrieval200ResponsePolicy**](ResolveRetrieval200ResponsePolicy.md) |  |
**query** | [**ResolveRetrieval200ResponseQuery**](ResolveRetrieval200ResponseQuery.md) |  |
**request_id** | **str** |  |
**skills** | [**List[ResolveRetrieval200ResponseSkillsInner]**](ResolveRetrieval200ResponseSkillsInner.md) |  |

## Example

```python
from openapi_client.models.resolve_retrieval200_response import ResolveRetrieval200Response

# TODO update the JSON string below
json = "{}"
# create an instance of ResolveRetrieval200Response from a JSON string
resolve_retrieval200_response_instance = ResolveRetrieval200Response.from_json(json)
# print the JSON string representation of the object
print(ResolveRetrieval200Response.to_json())

# convert the object into a dict
resolve_retrieval200_response_dict = resolve_retrieval200_response_instance.to_dict()
# create an instance of ResolveRetrieval200Response from a dict
resolve_retrieval200_response_from_dict = ResolveRetrieval200Response.from_dict(resolve_retrieval200_response_dict)
```
[[Back to Model list]](../README.md#documentation-for-models) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to README]](../README.md)
