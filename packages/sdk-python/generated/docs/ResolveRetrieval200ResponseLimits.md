# ResolveRetrieval200ResponseLimits


## Properties

Name | Type | Description | Notes
------------ | ------------- | ------------- | -------------
**canonical_threshold** | **float** |  |
**max_body_bytes** | **int** |  |
**max_candidates** | **int** |  |
**max_graph_depth** | **int** |  |
**max_resolved_skills** | **int** |  |
**supporting_threshold** | **float** |  |

## Example

```python
from openapi_client.models.resolve_retrieval200_response_limits import ResolveRetrieval200ResponseLimits

# TODO update the JSON string below
json = "{}"
# create an instance of ResolveRetrieval200ResponseLimits from a JSON string
resolve_retrieval200_response_limits_instance = ResolveRetrieval200ResponseLimits.from_json(json)
# print the JSON string representation of the object
print(ResolveRetrieval200ResponseLimits.to_json())

# convert the object into a dict
resolve_retrieval200_response_limits_dict = resolve_retrieval200_response_limits_instance.to_dict()
# create an instance of ResolveRetrieval200ResponseLimits from a dict
resolve_retrieval200_response_limits_from_dict = ResolveRetrieval200ResponseLimits.from_dict(resolve_retrieval200_response_limits_dict)
```
[[Back to Model list]](../README.md#documentation-for-models) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to README]](../README.md)
